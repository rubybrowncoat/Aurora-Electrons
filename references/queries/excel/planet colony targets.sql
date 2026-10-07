--drop view vw_tfplan;
--create view vw_tfplan as 


SELECT
	upper(substr(sys.Name,1,3)) as Sys
	,popName.BasicPopName
	,ifnull(pop.PopName,
	upper(substr(sys.Name,1,3))
		|| '-' 
		|| 
		CASE 
			WHEN str.Component = 1 then 'A'
			WHEN str.Component = 2 then 'B'	
			WHEN str.Component = 3 then 'C'	
			WHEN str.Component = 4 then 'D'	
			WHEN str.Component = 5 then 'E'	
			WHEN str.Component = 6 then 'F'	
			ELSE 'ZZZZZZZ'
		END	
		||
		CASE 
			WHEN sb.BodyTypeID = 1 THEN 'Ast' || sb.OrbitNumber
			WHEN sb.BodyTypeID = 14 THEN 'Com' || sb.OrbitNumber
			WHEN sb.ParentBodyType = 0 then (sb.PlanetNumber)			
			ELSE (sb.PlanetNumber || 'M' || sb.OrbitNumber)
		END 
	/*	*/
	)	as MyName
	,sb.Radius * 2 / 1000.0 as DiameterK
	,CASE 
		when surv.SystemBodyID is null 
			then sb.Radius/100.0 * CASE 
				when sb.BodyTypeID in (4,5) then 1
				when sb.BodyTypeID in (14) then 10
				else 10 end 
		else 0 
	end as SurvPts
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Duranium		/1000 ,0) end	as	Duranium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Neutronium		/1000 ,0) end	as	Neutronium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Corbomite		/1000 ,0) end	as	Corbomite
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Tritanium		/1000 ,0) end	as	Tritanium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Boronide		/1000 ,0) end	as	Boronide
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Mercassium		/1000 ,0) end	as	Mercassium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Vendarite		/1000 ,0) end	as	Vendarite
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Sorium			/1000 ,0) end	as	Sorium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Uridium		/1000 ,0) end	as	Uridium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Corundium		/1000 ,0) end	as	Corundium
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.Gallicite		/1000 ,0) end	as	Gallicite
	
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.DuraniumAcc	,0) end	as	DuraniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.NeutroniumAcc	,0) end	as	NeutroniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.CorbomiteAcc	,0) end	as	CorbomiteAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.TritaniumAcc	,0) end	as	TritaniumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.BoronideAcc	,0) end	as	BoronideAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.MercassiumAcc	,0) end	as	MercassiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.VendariteAcc	,0) end	as	VendariteAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.SoriumAcc		,0) end	as	SoriumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.UridiumAcc		,0) end	as	UridiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.CorundiumAcc	,0) end	as	CorundiumAcc
	,CASE when surv.SystemBodyID is null then -.000001 else ifnull(sb_mins.GalliciteAcc	,0) end	as	GalliciteAcc

	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc1M,0) end as Acc1mil
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc100k,0) end as Acc100k
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc10k,0) end as Acc10k
	,CASE when surv.SystemBodyID is null then '' else ifnull(sb_mins.Acc1k,0) end as Acc1k
	, CASE 
		when pop.SystemBodyID is not null then ifnull(sb_mins.CMCQualified/4.0,0) --CMCs will not appear on established colonies
		else ifnull(sb_mins.CMCQualified,0) end as CMCQualified --0 is not qualified; >= 1 is qualified; in between means would be qualified, but has a colony
	, ifnull(sb_mins.CMCScore,0)/1000000.0 as CMCScore
	,sb.BodyTypeID
	,sb.Gravity
	,sb.HydroExt/100 as Hydro
	,case 	
		WHEN sb.TidalLock = 1 THEN CASE			
			WHEN sb.ParentBodyType = 0 THEN 'Y' --planets, asteroids, comets
			ELSE 'M' --moons
			END		
		ELSE ''
	END as Tlock
	,IFNULL(pop.LastColonyCost, '') as ColCost
	,sb.BaseTemp
	,sb.Albedo
	,IFNULL(atm_ox.GasAtm,0) as Oxygen
	,IFNULL(atm_GH.GasAtm,0) as GH
	,IFNULL(atm_GHTox.GasAtm,0) as GHTox
	,IFNULL(atm_AGH.GasAtm,0) as AGH
	,IFNULL(atm_tox2.GasAtm,0) as Tox2
	,IFNULL(atm_tox3.GasAtm,0) as Tox3
	,IFNULL(atm_oth.GasAtm,0) as Oth
FROM
(
	select max(RaceID) as RaceID from FCT_Race where NPR = 0
) as Race
inner JOIN
	FCT_RaceSysSurvey as sys
on 
	sys.RaceID = Race.RaceID
inner JOIN
	FCT_SystemBody as sb
on
	sb.SystemID  = sys.SystemID
left JOIN
	FCT_Population as pop
on
	pop.SystemBodyID = sb.SystemBodyID
AND
	pop.RaceID = Race.RaceID
left JOIN
	vw_popname as popname
on
	popname.PopulationID = pop.PopulationID
left JOIN
	FCT_SystemBody as sb_parent
on
	sb_parent.SystemBodyID = sb.ParentBodyID
inner JOIN
	FCT_Star as str
on
	str.StarID = ifnull(sb_parent.ParentBodyID,sb.ParentBodyID)
or
(
	 --special case for Sol
	 --default bodies in Sol (i.e. not Minerva) have a ParentBodyID of 0
	 --since we know that Sol is a single-star system, we can just take the star that matches the SystemID
	ifnull(sb_parent.ParentBodyID,sb.ParentBodyID) = 0
	AND
	str.SystemID = sys.SystemID
)
left JOIN
	FCT_SystemBodySurveys as surv
on
	surv.RaceID = Race.RaceID
AND
	surv.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_AtmosphericGas as atm_ox
on
	atm_ox.SystemBodyID = sb.SystemBodyID
AND
	atm_ox.AtmosGasID = 10
left JOIN
	FCT_AtmosphericGas as atm_GH
on
	atm_GH.SystemBodyID = sb.SystemBodyID
AND
	atm_GH.AtmosGasID = 20
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	FROM
		FCT_AtmosphericGas as ag
	where
		ag.AtmosGasID in (3,13,14,15)		
	group by
		ag.SystemBodyID	
) as atm_GHTox
on
	atm_GHTox.SystemBodyID = sb.SystemBodyID
left JOIN
	FCT_AtmosphericGas as atm_AGH
on
	atm_AGH.SystemBodyID = sb.SystemBodyID
AND
	atm_AGH.AtmosGasID = 22
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (1,3,4,8,9,11,13,14,15,19)
		
	group by
		ag.SystemBodyID
) as atm_tox2
on
	atm_tox2.SystemBodyID = sb.SystemBodyID
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (16,17,18)
	group by
		ag.SystemBodyID
) as atm_tox3
on
	atm_tox3.SystemBodyID = sb.SystemBodyID
left JOIN
(
	SELECT
		ag.SystemBodyID
		,sum(ag.GasAtm) as GasAtm
	from
		FCT_AtmosphericGas as ag	
	where
		ag.AtmosGasID in (0,2,6,7,12)
	group by
		ag.SystemBodyID
) as atm_oth
on
	atm_oth.SystemBodyID = sb.SystemBodyID
left JOIN
(
	select 
		md.SystemBodyID
		,sum(case when md.MaterialID = 1 then md.Amount else 0 end) as Duranium
		,sum(case when md.MaterialID = 2 then md.Amount else 0 end) as Neutronium
		,sum(case when md.MaterialID = 3 then md.Amount else 0 end) as Corbomite
		,sum(case when md.MaterialID = 4 then md.Amount else 0 end) as Tritanium
		,sum(case when md.MaterialID = 5 then md.Amount else 0 end) as Boronide
		,sum(case when md.MaterialID = 6 then md.Amount else 0 end) as Mercassium
		,sum(case when md.MaterialID = 7 then md.Amount else 0 end) as Vendarite
		,sum(case when md.MaterialID = 8 then md.Amount else 0 end) as Sorium
		,sum(case when md.MaterialID = 9 then md.Amount else 0 end) as Uridium
		,sum(case when md.MaterialID = 10 then md.Amount else 0 end) as Corundium
		,sum(case when md.MaterialID = 11 then md.Amount else 0 end) as Gallicite

		,sum(case when md.MaterialID = 1 then md.Accessibility else 0 end) as DuraniumAcc
		,sum(case when md.MaterialID = 2 then md.Accessibility else 0 end) as NeutroniumAcc
		,sum(case when md.MaterialID = 3 then md.Accessibility else 0 end) as CorbomiteAcc
		,sum(case when md.MaterialID = 4 then md.Accessibility else 0 end) as TritaniumAcc
		,sum(case when md.MaterialID = 5 then md.Accessibility else 0 end) as BoronideAcc
		,sum(case when md.MaterialID = 6 then md.Accessibility else 0 end) as MercassiumAcc
		,sum(case when md.MaterialID = 7 then md.Accessibility else 0 end) as VendariteAcc
		,sum(case when md.MaterialID = 8 then md.Accessibility else 0 end) as SoriumAcc
		,sum(case when md.MaterialID = 9 then md.Accessibility else 0 end) as UridiumAcc
		,sum(case when md.MaterialID = 10 then md.Accessibility else 0 end) as CorundiumAcc
		,sum(case when md.MaterialID = 11 then md.Accessibility else 0 end) as GalliciteAcc

		,sum(case when md.Amount>=1000000 then md.Accessibility else 0 end ) as Acc1M
		,sum(case when md.Amount>=100000 then md.Accessibility else 0 end ) as Acc100k 
		,sum(case when md.Amount>=10000 then md.Accessibility else 0 end ) as Acc10k 
		,sum(case when md.Amount>=1000 then md.Accessibility else 0 end ) as Acc1k 
		,sum(CASE
			WHEN md.MaterialID in (1,11) and md.Amount >= 10000 and md.Accessibility >= 0.7 then 1
			ELSE 0
		END) as CMCQualified
		,sum(CASE
			WHEN md.MaterialID = 1 and md.Accessibility >= 0.5 then md.Amount * 2
			WHEN md.MaterialID <> 1 and md.Accessibility >= 0.5 then md.Amount
			ELSE 0
		END) as CMCScore
	from 
		FCT_MineralDeposit as md 
	group by 
		md.SystemBodyID
) as sb_mins
on
	sb_mins.SystemBodyID = surv.SystemBodyID
/*	
WHERE
	sys.Name = 'Dagger'
AND	
	sb.PlanetNumber = 3
*/
	
--order by 1
	