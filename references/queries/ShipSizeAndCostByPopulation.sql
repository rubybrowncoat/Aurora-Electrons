-- use your RaceID in the following line
with CTE_const as (select 785 as RaceID),	
CTE_game as (select g.GameID, g.GameTime from CTE_const as c inner join FCT_Race as r on r.RaceID =  c.RaceID inner join FCT_Game as g on g.GameID = r.GameID)

SELECT
	ifnull(p.PopName, '(none)') as Colony
	,sum
	(
		CASE
			when sc.Commercial = 0 and sc.ClassShippingLineID = 0 then sc.Cost	-- i'm not sure why i'm checking ClassShippingLineID, but maybe I had a reason, and it doesn't hurt to leave it
			else 0
		END
	) as TotalMilShipCost
	,sum
	(
		CASE
			when 
				sc.Commercial = 0 and sc.ClassShippingLineID = 0 		-- not a commercial ship	-- i'm not sure why i'm checking ClassShippingLineID, but maybe I had a reason, and it doesn't hurt to leave it
				and ifnull(sc_mother.CommercialHangar,1) = 1 			-- not in a military hangar
				and ifnull(st.TaskTypeID,0) <> 3						-- not being scrapped 		(can also filter out refit/autorefit tasks, but you probably want to include those ships)
				then sc.Cost
			else 0
		END
	) as TotalMilShipCostForMaintenance		-- ships in a mil hangar do not consume MSP
	,sum
	(
		CASE
			when sc.Commercial = 1 and sc.ClassShippingLineID = 0 then sc.Cost
			else 0
		END
	) as TotalCommShipCost
	,sum
	(
		CASE
			when sc.Commercial = 0 and sc.ClassShippingLineID = 0 then sc.Size * 50
			else 0
		END
	) as TotalMilShipTons
	,sum
	(
		CASE
			when sc.Commercial = 1 and sc.ClassShippingLineID = 0 then sc.Size * 50
			else 0
		END
	) as TotalCommShipTons
	,sum
	(
		CASE
			when 
				sc.Commercial = 0 								-- not a commercial ship
				and ifnull(sc_mother.CommercialHangar,1) = 1 	-- not in a military hangar
				and ifnull(st.TaskTypeID,0) <> 3				-- not being scrapped 		(can also filter out refit/autorefit tasks, but you probably want to include those ships)
				then sc.Size * 50
			else 0
		END
	) as TotalMilShipTonsForMaintenance
	,sum
	(
		CASE
			WHEN sc.MoraleCheckRequired = 1 and s.MaintenanceState = 2 -- MoraleCheckRequired = 0 for commercial ship classes, 1 for military
			THEN 
				( case when s.MaintClockYrs > 4 then 1.0 else s.MaintClockYrs / 4.0 end )	--overhaul years remaining, max 1
				*
				( sc.Cost )								--MSP per year of overhaul
			ELSE 0.0
		END
	) as OverhaulMSPCostOneYear
	,sum(
		CASE
			WHEN sc.SupplyShip = 1 then s.CurrentMaintSupplies - sc.MinimumSupplies 
			ELSE 0
			END
	) as SupplyShipMSPAvailable
	,sum(
		CASE
			WHEN s.MothershipID = 0 then sc.MaintModules	-- don't count maint modules on ships that are docked in a hangar
			ELSE 0
			END
	) as MaintModules
FROM
	FCT_Fleet as f
inner join CTE_const as c on c.RaceID = f.RaceID
inner join
(
	SELECT
		*
		,( 1.0*(g.GameTime-s.LastOverhaul)/86400/365 ) as MaintClockYrs	--maintenance clock in years
	from
		FCT_Ship as s
	inner join CTE_game as g on g.GameID = s.GameID
	inner join CTE_const as c on c.RaceID = s.RaceID
) as s
on
	s.FleetID = f.FleetID
inner JOIN
	FCT_ShipClass as sc
on
	sc.ShipClassID = s.ShipClassID
left JOIN
	FCT_Ship as s_mother
on
	s_mother.ShipID = s.MothershipID
left JOIN
	FCT_ShipClass as sc_mother
on
	sc_mother.ShipClassID = s_mother.ShipClassID
left JOIN
	FCT_ShipyardTask as st
on
	st.ShipID = s.ShipID
	
left join 
	FCT_Population as p
on
	p.PopulationID = f.AssignedPopulationID
group by
	f.AssignedPopulationID