with CTE_Params as
(
	select
		0.5 as minFuelPct
		,0.2 as minMSPPct
)


SELECT
-- this query returns all fleets designated as gas or supply stations that are currently low on fuel and/or msp and are not the target of a send message order or a refuel/resupply order
	f.*
FROM
(
	SELECT
		*
		,f.MaxMaintSupplies - CurrentMaintSupplies as MaintSuppliesNeeded
		
		,CASE
			when f.IsMaintStation = 1 then round(f.CurrentMaintSupplies / f.MaxMaintSupplies,2) else 0
		end as MSPPct
		,CASE
			when f.IsGasStation = 1 then round(f.FuelML / f.FuelCapacityML,2) else 0
		end as GASPct
		,CASE
			when f.IsGasStation = 1 and f.FuelML < f.FuelCapacityML * (select minFuelPct from CTE_Params) then 1 else 0
		end as NeedsGas
		,CASE
			when f.IsMaintStation = 1 and f.CurrentMaintSupplies < f.MaxMaintSupplies * (select minMSPPct from CTE_Params) then 1 else 0
		end as NeedsMSP
	FROM
	(
		select
			FleetName
			,f.FleetID
			, f.IsGasStation
			, f.IsMaintStation
			,sum(CASE when sc.FuelTanker = 1 then sc.FuelCapacity else 0 end) /1000/1000.0 as FuelCapacityML
			,round(sum(CASE when sc.FuelTanker = 1 then s.Fuel else 0 end)/1000/1000.0,3) as FuelML
			,round(sum(CASE when sc.FuelTanker = 1 then sc.FuelCapacity - s.Fuel else 0 end) /1000/1000,1) as FuelNeededML
			,sum(CASE when sc.SupplyShip = 1 then sc.MaintSupplies else 0 end) as MaxMaintSupplies
			,sum(CASE when sc.SupplyShip = 1 then round(s.CurrentMaintSupplies,2) else 0 end) as CurrentMaintSupplies
		FROM
		(
			select
				*
				,
				f.FleetName,
				CASE
					when f.FleetName like '%xxx' then 0
					when 
							f.FleetName like '%\_\_\_GAS%' Escape '\'
						or
							(f.FleetName like '%\_\_\_GATE%' Escape '\' and f.FleetName not like '%NOGAS%') --NOGAS is used on gate fleets that are C only (no ST or SW)
						then --1
						
							CASE
								WHEN ifnull(pi_ref.Amount,0) = 0 then 1 -- not in orbit of a colony with refuelling capability
									
								else 0
							end
						
					else 0
				end as IsGasStation
				,CASE
					when f.FleetName like '%NOGAS%' then 0 --NOGAS is used on gate fleets that are C only (no ST or SW)
					when (
						f.FleetName like '%\_\_\_MNT%' Escape '\' 
						or f.FleetName like '%\_\_\_GASMNT%' Escape '\' 
						or f.FleetName like '%\_\_\_GATE%' Escape '\' 
						or f.FleetName like '%\_\_\_GASSS%' Escape '\') 
					then
						CASE
							WHEN ifnull(pi_mf.Amount,0) = 0 then 1 -- not in orbit of a ground colony with maintenance facilities
								
							else 0
						end						
					else 0
				end as IsMaintStation
			FROM
				FCT_Fleet as f
			inner JOIN
				vw_const as c
			on
				c.RaceID = f.RaceID	
			left JOIN
				FCT_SystemBody as sb
			on
				sb.SystemBodyID = f.OrbitBodyID
			--left join FCT_Population as p on p.SystemBodyID = sb.SystemBodyID AND p.RaceID = f.RaceID
			left join 
			(
				select p.SystemBodyID, sum(pi.Amount) as Amount from FCT_PopulationInstallations as pi 
				inner join FCT_Population as p on p.PopulationID = pi.PopID				
				where pi.PlanetaryInstallationID = 21		-- maintenance facility
				group by p.SystemBodyID
			) as pi_mf
			on 
				pi_mf.SystemBodyID = f.OrbitBodyID
			left join 
			(
				SELECT
					p.SystemBodyID
					,sum(pi.Amount) as Amount
				from
					FCT_PopulationInstallations as pi
				inner join FCT_Population as p on p.PopulationID = pi.PopID
				where pi.PlanetaryInstallationID in (33,43) -- 33 Spaceport		43 Refuelling Station
				group by p.SystemBodyID
				order by p.SystemBodyID
			) as pi_ref
			on pi_ref.SystemBodyID = f.OrbitBodyID
		) as f
		inner JOIN
			FCT_Ship as s
		on 
			s.FleetID = f.FleetID
		inner JOIN
			FCT_ShipClass as sc
		on
			sc.ShipClassID = s.ShipClassID
		AND
		(
			(sc.SupplyShip = 1 and f.IsMaintStation = 1)
			OR
			(sc.FuelTanker = 1 and f.IsGasStation = 1)
		)
		group by FleetName, f.FleetID, f.IsGasStation, f.IsMaintStation
	) as f
) as f
left JOIN
	FCT_MoveOrders as mo
on
	mo.DestinationID = f.FleetID
AND
(
	mo.MoveActionID = 112 -- send message
	or
	(f.NeedsGas = 1 and mo.MoveActionID = 230) -- refuel stationary fleet
	or
	(f.NeedsMSP = 1 and mo.MoveActionID = 231) -- resupply stationary fleet
)
WHERE
(
	f.NeedsGas = 1
	or
	f.NeedsMSP = 1
)
AND
	mo.MoveOrderID is null
order by
	NeedsGas desc