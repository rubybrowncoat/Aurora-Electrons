--drop view vw_popname; 
--create view vw_popname as 
SELECT
	pop.PopulationID
	,pop.PopName
	--,instr(pop.PopName,' ')
	,CASE
		WHEN instr(pop.PopName,' ') > 0 THEN substr(pop.PopName,1,instr(pop.PopName,' ')-1)
		ELSE pop.PopName
	END as BasicPopName
FROM
	FCT_Population as pop
